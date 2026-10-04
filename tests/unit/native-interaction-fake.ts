import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import type { TestContext } from 'node:test'
import type { AppBuild, NativeKind, ResetPolicy } from '../../src/browser/contract.ts'
import type { AppBundle, NativeExecutionIdentity } from '../../src/native/identity.ts'
import type { NativeTools, RecordedProcess } from '../../src/native/processes.ts'
import type { AppProcessReading, CaptureSource, DriverAnswer, LaunchSpec, NativeAppDriver } from '../../src/native/session.ts'
import type { ScopedSource } from '../../src/native/source-scope.ts'
import type { ExecutorAppState, ExecutorSession, RequestBounds } from '../../src/native/webdriver-client.ts'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NativeInteractionSession } from '../../src/native/interaction-session.ts'
import { elementTypeNumbers } from '../../src/native/locators.ts'
import { systemTools } from '../../src/native/processes.ts'
import { NativeAppSession } from '../../src/native/session.ts'
import { ExecutorClient } from '../../src/native/webdriver-client.ts'
import { isPlainObject } from '../../src/protocol/schema.ts'

// A stand-in for an XCTest executor with a small app inside it, for the interaction layer's unit tests. It serves the
// routes the interaction layer and the session send, over real HTTP on 127.0.0.1, so requests that hang or drop end as
// the client ends them on a real executor. The app is a tree of elements that a test builds; a tap on a field focuses
// it and on iOS brings up a software keyboard, keys type into the focused field, and a button runs its reaction.
// Attributes come out as each executor writes them: WebDriverAgent's `type`, `name` (the identifier, or the label when
// there is none) and JSON booleans, the macOS runner's `elementType` numbers, `identifier` and `"true"` strings.

/** An element of the stand-in's app. A field's `text` is what was typed; a secure field shows it as bullets. */
export type FakeElement = {
  type: string
  identifier?: string
  label?: string
  title?: string
  value?: string
  placeholder?: string
  text?: string
  enabled?: boolean
  visible?: boolean
  selected?: boolean
  traits?: string
  frame?: { x: number; y: number; width: number; height: number }
  hittable?: boolean
  /** An executor that cannot expose keyboard focus, even while the field receives input. */
  reportedFocus?: boolean
  /** A macOS secure field that reads back as nothing even while it is edited, as AppKit's does once editing ends. */
  showsNothing?: boolean
  /** Each read of its frame moves it one point, as a sheet that keeps sliding. */
  moving?: boolean
  /** On iOS, whether the keyboard's return key dismisses the keyboard while this field holds the focus. */
  returnDismisses?: boolean
  children?: FakeElement[]
  onClick?: (app: FakeApp) => void
}

/** How one route misbehaves: it never answers, drops its connection, answers late, with an error or with this value. */
export type FakeBehaviour = { hang?: boolean; drop?: boolean; delayMs?: number; error?: string; answer?: unknown }

/** One request the stand-in received: the route, as the client names it, and the body as text. */
export type FakeRequest = { route: string; path: string; body: string }

const pngPixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

/** The stand-in: the app's screen, its state, and every request it received. */
export class FakeApp {
  readonly platform: NativeKind
  readonly bundleId: string
  readonly appName: string
  readonly pid: number = 4242
  readonly requests: FakeRequest[] = []
  readonly behaviours: Map<string, FakeBehaviour> = new Map()
  readonly windowFrame: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } = { x: 20, y: 60, width: 700, height: 480 }
  /** Builds the screen afresh at each launch, so elements of an earlier launch are stale. */
  screen: (app: FakeApp) => FakeElement[]
  elements: FakeElement[] = []
  running: boolean = false
  inFront: boolean = true
  focused: FakeElement | undefined
  keyboardShown: boolean = false
  /** Whether the next keyboard to come up carries the first-run card about sliding to type. */
  firstRunCard: boolean = false
  /** An alert of the app's own, shown in its tree. */
  alert: FakeElement | undefined
  /** Whether the macOS app shows no window yet, as just after a launch. */
  windowHidden: boolean = false
  /** An alert of the system, which only WebDriverAgent's alert routes see. */
  systemAlert: { text: string; buttons: string[] } | undefined
  readonly #ids = new Map<FakeElement, string>()
  readonly #byId = new Map<string, FakeElement>()
  readonly #sockets = new Set<Socket>()
  readonly #server = createServer((request, response) => this.#receive(request, response))
  #sessionId = 'fake-session-1'
  #sessions = 1
  #card: FakeElement | undefined
  #keyboardElement: FakeElement | undefined

  constructor(options: { readonly platform: NativeKind; readonly screen: (app: FakeApp) => FakeElement[] }) {
    this.platform = options.platform
    this.bundleId = options.platform === 'macos' ? 'dev.retest.fixtures.taskdesk' : 'dev.retest.fixtures.taskphone'
    this.appName = options.platform === 'macos' ? 'TaskDesk' : 'TaskPhone'
    this.screen = options.screen
    this.#server.on('connection', (socket) => {
      this.#sockets.add(socket)
      socket.on('close', () => this.#sockets.delete(socket))
    })
  }

  get sessionId(): string {
    return this.#sessionId
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve) => this.#server.listen(0, '127.0.0.1', resolve))
    const address = this.#server.address()
    return address !== null && typeof address === 'object' ? address.port : 0
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      for (const socket of this.#sockets) socket.destroy()
      this.#server.close(() => resolve())
    })
  }

  /** The requests on one route, in order. */
  on(route: string): FakeRequest[] {
    return this.requests.filter((request) => request.route === route)
  }

  /** The first element with this identifier in the current screen. */
  find(identifier: string): FakeElement {
    const found = this.#walk().find((element) => element.identifier === identifier)
    if (found === undefined) throw new Error(`no element ${identifier}`)
    return found
  }

  /** Shows the keyboard, as a tap on a field does on iOS, with the first-run card when it is due. */
  showKeyboard(): void {
    this.keyboardShown = true
    if (this.firstRunCard) {
      this.firstRunCard = false
      this.#card = { type: 'Other', frame: { x: 0, y: 560, width: 402, height: 120 }, children: [{ type: 'StaticText', label: 'Speed up your typing by sliding your finger across the letters to compose a word.', frame: { x: 20, y: 570, width: 360, height: 40 } }, { type: 'Button', label: 'Continue', frame: { x: 150, y: 620, width: 100, height: 44 }, onClick: () => { this.#card = undefined } }] }
    }
  }

  /** The app's whole tree as the executor's `/source` serves it, menu bar included on macOS. */
  xml(): string {
    if (this.platform === 'ios-simulator') {
      const children = [...this.elements, ...this.#extras()]
      return `<?xml version="1.0" encoding="UTF-8"?><XCUIElementTypeApplication type="XCUIElementTypeApplication" name="${this.appName}" label="${this.appName}" enabled="true" visible="true" x="0" y="0" width="402" height="874" bundleId="${this.bundleId}" processId="${this.pid}">${children.map((child) => this.#node(child)).join('')}</XCUIElementTypeApplication>`
    }
    const window = this.windowFrame
    const inside = [...this.elements, ...this.#extras()]
    if (this.windowHidden) return `<?xml version="1.0" encoding="UTF-8"?><XCUIElementTypeApplication elementType="2" identifier="" label="" title="${this.appName}" enabled="true" selected="false" x="0" y="0" width="0" height="0"></XCUIElementTypeApplication>`
    return `<?xml version="1.0" encoding="UTF-8"?><XCUIElementTypeApplication elementType="2" identifier="" label="" title="${this.appName}" enabled="true" selected="false" x="0" y="0" width="0" height="0"><XCUIElementTypeMenuBar elementType="55" identifier="" label="" title="" enabled="true" selected="false" x="0" y="0" width="1728" height="33"><XCUIElementTypeMenuItem elementType="54" identifier="" label="" title="Recent Items: secret-file.txt" enabled="true" selected="false" x="0" y="0" width="10" height="10"/></XCUIElementTypeMenuBar><XCUIElementTypeWindow elementType="4" identifier="main" label="" title="${this.appName}" enabled="false" selected="false" x="${window.x}" y="${window.y}" width="${window.width}" height="${window.height}">${inside.map((child) => this.#node(child)).join('')}</XCUIElementTypeWindow></XCUIElementTypeApplication>`
  }

  #extras(): FakeElement[] {
    const extras: FakeElement[] = []
    if (this.alert !== undefined) extras.push(this.alert)
    if (this.keyboardShown) extras.push(this.#keyboard())
    return extras
  }

  // The keyboard keeps its elements while it is up, as the executor keeps their ids; the card is its last child.
  #keyboard(): FakeElement {
    this.#keyboardElement ??= this.#makeKeyboard()
    const keyboard = this.#keyboardElement
    const card = this.#card
    return { ...keyboard, children: card === undefined ? keyboard.children ?? [] : [...(keyboard.children ?? []), card] }
  }

  #makeKeyboard(): FakeElement {
    const keys: FakeElement[] = [
      { type: 'Key', label: 'q', frame: { x: 4, y: 620, width: 36, height: 44 } },
      { type: 'Button', identifier: 'Return', label: 'done', frame: { x: 300, y: 800, width: 90, height: 44 }, onClick: (app) => {
        if (app.focused?.returnDismisses === true) {
          app.keyboardShown = false
          app.focused = undefined
        }
      } },
    ]
    return { type: 'Keyboard', frame: { x: 0, y: 560, width: 402, height: 314 }, children: keys }
  }

  #node(element: FakeElement): string {
    const attributes = this.#attributes(element)
    const text = Object.entries(attributes).map(([name, value]) => ` ${name}="${escape(value)}"`).join('')
    const tag = `XCUIElementType${element.type}`
    const children = element.children ?? []
    return children.length === 0 ? `<${tag}${text}/>` : `<${tag}${text}>${children.map((child) => this.#node(child)).join('')}</${tag}>`
  }

  #attributes(element: FakeElement): Record<string, string> {
    const frame = element.frame ?? { x: 0, y: 0, width: 0, height: 0 }
    const value = this.#value(element)
    const placeholder = element.placeholder === undefined ? {} : { placeholderValue: element.placeholder }
    if (this.platform === 'ios-simulator') {
      const name = element.identifier ?? element.label
      return {
        type: `XCUIElementType${element.type}`,
        ...(value === undefined ? {} : { value }),
        ...(name === undefined ? {} : { name }),
        ...(element.label === undefined ? {} : { label: element.label }),
        enabled: String(element.enabled ?? true),
        visible: String(element.visible ?? true),
        x: String(frame.x),
        y: String(frame.y),
        width: String(frame.width),
        height: String(frame.height),
        ...placeholder,
        traits: element.traits ?? '',
      }
    }
    return {
      elementType: String(elementTypeNumbers[element.type] ?? 1),
      identifier: element.identifier ?? '',
      ...(value === undefined ? {} : { value }),
      label: element.label ?? '',
      title: element.title ?? '',
      enabled: String(element.enabled ?? true),
      selected: String(element.selected ?? false),
      x: String(frame.x),
      y: String(frame.y),
      width: String(frame.width),
      height: String(frame.height),
      ...placeholder,
    }
  }

  // What the executor shows as a value: a secure field's masking characters, U+2022 on iOS and on macOS U+F79A while it
  // is edited and nothing otherwise, a field's text, or on iOS its placeholder while it is empty, and a static text's
  // label when it has no value.
  #value(element: FakeElement): string | undefined {
    if (element.text !== undefined) {
      const length = [...element.text].length
      if (element.type === 'SecureTextField' && this.platform === 'ios-simulator') return '\u2022'.repeat(length)
      if (element.type === 'SecureTextField') return this.focused === element && element.showsNothing !== true ? '\uf79a'.repeat(length) : ''
      if (this.platform === 'ios-simulator' && element.text === '' && element.placeholder !== undefined) return element.placeholder
      return element.text
    }
    if (this.platform === 'ios-simulator' && element.type === 'StaticText' && element.value === undefined) return element.label
    return element.value
  }

  #walk(): FakeElement[] {
    const found: FakeElement[] = []
    const visit = (element: FakeElement): void => {
      found.push(element)
      for (const child of element.children ?? []) visit(child)
    }
    for (const element of [...this.elements, ...this.#extras()]) visit(element)
    return found
  }

  #idOf(element: FakeElement): string {
    const known = this.#ids.get(element)
    if (known !== undefined) return known
    const id = `el-${this.#ids.size + 1}`
    this.#ids.set(element, id)
    this.#byId.set(id, element)
    return id
  }

  #receive(request: IncomingMessage, response: ServerResponse): void {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      const parsed: unknown = text === '' ? {} : JSON.parse(text)
      const body = isPlainObject(parsed) ? parsed : {}
      const path = request.url ?? '/'
      const route = `${request.method ?? 'GET'} ${routeOf(path)}`
      this.requests.push({ route, path, body: text })
      void this.#answer(route, path, body, request, response)
    })
  }

  async #answer(route: string, path: string, body: Record<string, unknown>, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const behaviour = this.behaviours.get(route) ?? {}
    if (behaviour.hang === true) return
    if (behaviour.drop === true) {
      request.socket.destroy()
      return
    }
    if (behaviour.delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, behaviour.delayMs))
    const send = (status: number, value: unknown): void => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ value, sessionId: this.#sessionId }))
    }
    const refuse = (error: string, message: string): void => send(error === 'unknown error' ? 500 : 404, { error, message, traceback: '' })
    if (behaviour.error !== undefined) return refuse(behaviour.error, `the stand-in was told to answer ${behaviour.error}`)
    if ('answer' in behaviour) return send(200, behaviour.answer)
    if (route === 'GET /status') return send(200, { ready: true, os: { version: 'Fake OS 1.0' } })
    if (route === 'POST /session') {
      this.#sessions += 1
      this.#sessionId = `fake-session-${this.#sessions}`
      return send(200, { sessionId: this.#sessionId, capabilities: {} })
    }
    const named = /^\/session\/([^/]+)/.exec(path)?.[1]
    if (named !== undefined && named !== this.#sessionId) return refuse('invalid session id', `Session does not exist: ${named}`)
    const elementId = /\/element\/([^/]+)/.exec(path)?.[1]
    const element = elementId === undefined ? undefined : this.#byId.get(decodeURIComponent(elementId))
    const current = element !== undefined && this.#walk().includes(element)
    const needsElement = elementId !== undefined
    if (needsElement && !current) return refuse('stale element reference', `The element ${elementId} is not part of the screen any more`)
    switch (route) {
      case 'DELETE /session/:session':
        return send(200, null)
      case 'POST /session/:session/wda/apps/launch':
        if (!this.running) {
          this.running = true
          this.focused = undefined
          this.keyboardShown = false
          this.elements = this.screen(this)
        }
        return send(200, null)
      case 'POST /session/:session/wda/apps/activate':
        return send(200, null)
      case 'POST /session/:session/wda/apps/terminate': {
        const was = this.running
        this.running = false
        this.elements = []
        return send(200, was)
      }
      case 'POST /session/:session/wda/apps/state':
        return send(200, this.running ? (this.inFront ? 4 : 3) : 1)
      case 'GET /session/:session/window/rect':
        return send(200, this.platform === 'macos' ? { x: 0, y: 0, width: 1728, height: 1117 } : { x: 0, y: 0, width: 402, height: 874 })
      case 'GET /session/:session/screenshot':
        return send(200, pngPixel.toString('base64'))
      case 'GET /session/:session/source':
        return send(200, this.xml())
      case 'POST /session/:session/elements':
      case 'POST /session/:session/element/:element/elements': {
        const predicate = typeof body['value'] === 'string' ? body['value'] : ''
        const matcher = this.#predicate(predicate)
        if (matcher === undefined) return refuse('invalid selector', `The predicate ${predicate} names an attribute the stand-in does not know`)
        const scope = element === undefined ? this.#walk() : this.#within(element)
        return send(200, scope.filter(matcher).map((each) => ({ 'element-6066-11e4-a52e-4f735466cecf': this.#idOf(each), ELEMENT: this.#idOf(each) })))
      }
      case 'GET /session/:session/element/:element/attribute/:name':
        return element === undefined ? refuse('no such element', 'no element') : send(200, this.#attribute(element, decodeURIComponent(path.slice(path.lastIndexOf('/') + 1))))
      case 'GET /session/:session/element/:element/rect': {
        if (element === undefined) return refuse('no such element', 'no element')
        const frame = element.frame ?? { x: 0, y: 0, width: 0, height: 0 }
        if (element.moving === true) element.frame = { ...frame, x: frame.x + 1 }
        return send(200, element.frame ?? frame)
      }
      case 'POST /session/:session/element/:element/click':
        if (element !== undefined) this.#click(element)
        return send(200, null)
      case 'POST /session/:session/wda/keys':
        this.#keys(body)
        return send(200, null)
      case 'POST /session/:session/actions':
        return send(200, null)
      case 'POST /session/:session/wda/element/:element/scroll':
        return send(200, null)
      case 'GET /session/:session/alert/text': {
        const alert = this.#executorAlert()
        return alert === undefined ? refuse('no such alert', 'No alert is open') : send(200, alert.text)
      }
      case 'GET /session/:session/wda/alert/buttons': {
        const alert = this.#executorAlert()
        return alert === undefined ? refuse('no such alert', 'No alert is open') : send(200, alert.buttons)
      }
      case 'POST /session/:session/alert/accept':
      case 'POST /session/:session/alert/dismiss': {
        const alert = this.#executorAlert()
        if (alert === undefined) return refuse('no such alert', 'No alert is open')
        const name = typeof body['name'] === 'string' ? body['name'] : ''
        if (!alert.buttons.includes(name)) return refuse('unknown error', `Failed to find button with label '${name}' for alert`)
        if (this.systemAlert !== undefined) this.systemAlert = undefined
        else this.alert = undefined
        return send(200, null)
      }
      default:
        return refuse('unknown command', `Unhandled endpoint: ${route}`)
    }
  }

  #executorAlert(): { text: string; buttons: string[] } | undefined {
    if (this.systemAlert !== undefined) return this.systemAlert
    if (this.alert === undefined) return undefined
    const inside = this.#within(this.alert)
    return { text: inside.filter((each) => each.type === 'StaticText').map((each) => each.label ?? '').join('\n'), buttons: inside.filter((each) => each.type === 'Button').map((each) => each.label ?? '') }
  }

  #within(element: FakeElement): FakeElement[] {
    const found: FakeElement[] = []
    const visit = (each: FakeElement): void => {
      found.push(each)
      for (const child of each.children ?? []) visit(child)
    }
    visit(element)
    return found
  }

  #attribute(element: FakeElement, name: string): unknown {
    const ios = this.platform === 'ios-simulator'
    const flag = (value: boolean): boolean | string => (ios ? value : String(value))
    if (name === 'hittable') return flag(element.hittable ?? true)
    if (name === 'focused') return flag(element.reportedFocus ?? this.focused === element)
    if (name === 'identifier') return ios ? null : (element.identifier ?? '')
    const attributes = this.#attributes(element)
    return attributes[name] ?? null
  }

  #click(element: FakeElement): void {
    if (['TextField', 'SecureTextField', 'SearchField', 'TextView'].includes(element.type)) {
      this.focused = element
      if (this.platform === 'ios-simulator' && !this.keyboardShown) this.showKeyboard()
    }
    element.onClick?.(this)
  }

  #keys(body: Record<string, unknown>): void {
    const field = this.focused
    if (field === undefined) return
    const value = body['value']
    const keys = body['keys']
    let selectAll = false
    if (Array.isArray(value)) {
      for (const character of value.join('')) {
        const typed = field.text ?? ''
        if (character === '\b') field.text = [...typed].slice(0, -1).join('')
        else if (character === '\u007f') field.text = typed
        else field.text = `${typed}${character}`
      }
      return
    }
    if (!Array.isArray(keys)) return
    for (const key of keys) {
      const typed = field.text ?? ''
      if (typeof key === 'string') {
        if (key === 'XCUIKeyboardKeyDelete') field.text = selectAll ? '' : [...typed].slice(0, -1).join('')
        else if (key === 'XCUIKeyboardKeyReturn') continue
        else field.text = `${selectAll ? '' : typed}${key}`
        selectAll = false
        continue
      }
      if (!isPlainObject(key) || typeof key['key'] !== 'string') continue
      const flags = typeof key['modifierFlags'] === 'number' ? key['modifierFlags'] : 0
      if (key['key'] === 'a' && flags === 16) {
        selectAll = true
        continue
      }
      field.text = `${selectAll ? '' : typed}${flags === 2 ? key['key'].toUpperCase() : key['key']}`
      selectAll = false
    }
  }

  // Our predicates only: `key == "text"` and `elementType == 9`, joined by AND, over the attributes each executor names.
  #predicate(predicate: string): ((element: FakeElement) => boolean) | undefined {
    const parts = predicate.split(' AND ').map((part) => /^(\w+) == ("(?:[^"\\]|\\.)*"|\d+)$/.exec(part.trim()))
    if (parts.some((part) => part === null)) return undefined
    const known = this.platform === 'macos' ? ['elementType', 'identifier', 'label', 'title'] : ['type', 'name', 'label']
    const pairs = parts.flatMap((part) => {
      if (part === null) return []
      const value: unknown = JSON.parse(part[2] ?? '""')
      return [{ key: part[1] ?? '', value }]
    })
    if (pairs.some((pair) => !known.includes(pair.key))) return undefined
    return (element) => {
      const attributes = this.#attributes(element)
      return pairs.every((pair) => attributes[pair.key] === String(pair.value))
    }
  }
}

function routeOf(path: string): string {
  return path
    .replace(/\/session\/[^/]+/, '/session/:session')
    .replace(/\/element\/[^/]+/, '/element/:element')
    .replace(/\/attribute\/[^/]+$/, '/attribute/:name')
}

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '&#10;')
}

// The session's own driver over the stand-in: the lifecycle through the executor session, the app's process as the
// stand-in's flag, and the tree cut by the session's scope.
class FakeDriver implements NativeAppDriver {
  readonly platform: NativeKind
  readonly bundle: AppBundle
  readonly identity: NativeExecutionIdentity
  readonly resetPolicy: ResetPolicy = { appData: 'kept', keychain: 'kept' }
  readonly runtimeProcessIds: readonly number[] = []
  readonly captureSources: readonly CaptureSource[] = ['executor-screen']
  readonly #app: FakeApp
  readonly #executor: ExecutorSession
  readonly #target: { readonly bundleId: string }

  constructor(app: FakeApp, executor: ExecutorSession) {
    this.#app = app
    this.#executor = executor
    this.platform = app.platform
    this.#target = { bundleId: app.bundleId }
    this.bundle = { appPath: `/fake/${app.appName}.app`, bundleId: app.bundleId, executable: app.appName, platforms: [app.platform === 'macos' ? 'MacOSX' : 'iPhoneSimulator'], sha256: '0'.repeat(64) }
    this.identity = {
      platform: app.platform,
      app: { bundleId: app.bundleId, path: this.bundle.appPath, sha256: this.bundle.sha256 },
      os: { name: app.platform === 'macos' ? 'macOS' : 'iOS', version: '26.5', build: 'fake' },
      executor: { name: app.platform === 'macos' ? 'mac2' : 'webdriveragent', version: '0', commit: '0', commitVerified: false, productsSha256: '0', origin: 'adopted' },
      xcode: { version: '26.5', build: 'fake' },
    }
  }

  async install(build: AppBuild): Promise<DriverAnswer<unknown>> {
    void build
    return { status: 'answered', value: null, durationMs: 0 }
  }

  async launchBlocker(): Promise<undefined> {
    return undefined
  }

  launch(launch: LaunchSpec, bounds: RequestBounds): Promise<DriverAnswer<unknown>> {
    return this.#executor.launchApp({ target: this.#target, ...launch }, bounds)
  }

  activate(bounds: RequestBounds): Promise<DriverAnswer<unknown>> {
    return this.#executor.activateApp(this.#target, bounds)
  }

  terminate(bounds: RequestBounds): Promise<DriverAnswer<boolean>> {
    return this.#executor.terminateApp(this.#target, bounds)
  }

  state(bounds: RequestBounds): Promise<DriverAnswer<ExecutorAppState>> {
    return this.#executor.appState(this.#target, bounds)
  }

  async processState(): Promise<AppProcessReading> {
    const running = this.#app.running
    return { ok: true, running, pids: running ? [this.#app.pid] : [], processes: running ? [{ pid: this.#app.pid, command: `/fake/${this.#app.appName}.app/Contents/MacOS/${this.#app.appName}` }] : [] }
  }

  capture(_source: CaptureSource, bounds: RequestBounds): Promise<DriverAnswer<Uint8Array>> {
    return this.#executor.screenshot(bounds)
  }

  source(bounds: RequestBounds): Promise<DriverAnswer<ScopedSource>> {
    return this.#executor.ownedSource({ platform: this.platform, bundleId: this.#app.bundleId, appNames: [this.#app.appName] }, bounds)
  }

  async forceEnd(processes: readonly RecordedProcess[]): Promise<string[]> {
    void processes
    this.#app.running = false
    return []
  }

  async endExecutorSession(bounds: RequestBounds): Promise<string[]> {
    const ended = await this.#executor.end(bounds)
    return ended.status === 'answered' || ended.status === 'refused' ? [] : [ended.message]
  }

  released(): void {}
}

/** The fake macOS tools the front check reads: a window list and a process list a test can change. */
export type FakeWindowTools = { readonly tools: NativeTools; setWindows(windows: readonly (readonly [number, number, number, number, number, number])[]): Promise<void> }

async function fakeWindowTools(t: TestContext, app: FakeApp): Promise<FakeWindowTools> {
  const folder = await mkdtemp(join(tmpdir(), 'retest-native-interaction-tools-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const windows = join(folder, 'windows.json')
  const processes = join(folder, 'ps.txt')
  const script = async (name: string, file: string): Promise<string> => {
    const path = join(folder, name)
    await writeFile(path, `#!/bin/sh\ncat '${file}'\n`)
    await chmod(path, 0o755)
    return path
  }
  const frame = app.windowFrame
  const setWindows = (list: readonly (readonly [number, number, number, number, number, number])[]): Promise<void> => writeFile(windows, JSON.stringify(list))
  await setWindows([[app.pid, 0, frame.x, frame.y, frame.width, frame.height]])
  await writeFile(processes, `  ${app.pid} /fake/${app.appName}.app/Contents/MacOS/${app.appName}\n  900 /System/Library/CoreServices/Dock.app/Contents/MacOS/Dock\n  950 /System/Library/PrivateFrameworks/AutomationMode.framework/AutomationModeUI.app/Contents/MacOS/AutomationModeUI\n`)
  // The interaction layer runs only these two tools; every other one stays the system's and is never run here.
  return { tools: { ...systemTools, ps: await script('ps', processes), osascript: await script('osascript', windows) }, setWindows }
}

/** A stand-in app with its interaction session open on it, launched, and everything closed after the test. */
export type FakeInteraction = { readonly app: FakeApp; readonly interaction: NativeInteractionSession; readonly session: NativeAppSession; readonly executor: ExecutorSession; readonly windows?: FakeWindowTools }

/**
 * Starts the stand-in, opens a session and its interaction session on it and launches the app, as a runtime would.
 *
 * @example const { app, interaction } = await openFake(t, { platform: 'ios-simulator', screen: () => [button] })
 */
export async function openFake(t: TestContext, options: { readonly platform: NativeKind; readonly screen: (app: FakeApp) => FakeElement[]; readonly redact?: (text: string) => string; readonly launch?: boolean }): Promise<FakeInteraction> {
  const app = new FakeApp(options)
  const port = await app.listen()
  const client = new ExecutorClient({ executor: options.platform === 'macos' ? 'mac2' : 'webdriveragent', host: '127.0.0.1', port })
  const created = await client.createSession({ timeoutMs: 2000 })
  if (created.status !== 'answered') throw new Error('the stand-in opened no session')
  const executor = created.value
  const redact = options.redact ?? ((text: string) => text)
  const session = new NativeAppSession(new FakeDriver(app, executor), { owner: { runId: 'run', testId: 'test', attemptId: 'attempt', app: options.platform === 'macos' ? 'desk' : 'phone' }, launch: { arguments: [], environment: {} }, redact })
  const windows = options.platform === 'macos' ? await fakeWindowTools(t, app) : undefined
  const interaction = new NativeInteractionSession({
    session,
    client,
    executor,
    redact,
    processes: async () => ({ ok: true, running: app.running, pids: app.running ? [app.pid] : [] }),
    ...(windows === undefined ? {} : { tools: windows.tools }),
  })
  t.after(async () => {
    await interaction.dispose(5000).catch(() => undefined)
    await app.close()
  })
  if (options.launch !== false) {
    const launched = await interaction.launch(5000)
    if (!launched.result.ok) throw new Error(launched.result.failure.message)
    app.requests.length = 0
  }
  return { app, interaction, session, executor, ...(windows === undefined ? {} : { windows }) }
}

/** TaskPhone's sign-in screen as the stand-in shows it. */
export function phoneSignIn(): FakeElement[] {
  return [
    { type: 'StaticText', identifier: 'service-status', label: 'Connected to http://127.0.0.1:4310', frame: { x: 16, y: 168, width: 370, height: 55 } },
    { type: 'TextField', identifier: 'account-field', label: 'Account', placeholder: 'Account', text: '', frame: { x: 16, y: 260, width: 370, height: 44 } },
    { type: 'SecureTextField', identifier: 'password-field', label: 'Password', placeholder: 'Password', text: '', frame: { x: 16, y: 310, width: 370, height: 44 } },
    { type: 'Button', identifier: 'sign-in-button', label: 'Sign in', frame: { x: 16, y: 360, width: 370, height: 44 } },
  ]
}

/** TaskDesk's sign-in form as the stand-in shows it, inside its window at 20,60. */
export function deskSignIn(): FakeElement[] {
  return [
    { type: 'StaticText', identifier: 'service-status', value: 'Connected to http://127.0.0.1:4310', frame: { x: 40, y: 100, width: 200, height: 16 } },
    { type: 'StaticText', value: 'Account', frame: { x: 48, y: 136, width: 51, height: 16 } },
    { type: 'TextField', identifier: 'account-field', text: '', frame: { x: 105, y: 131, width: 296, height: 26 } },
    { type: 'SecureTextField', identifier: 'password-field', text: '', frame: { x: 105, y: 163, width: 296, height: 26 } },
    { type: 'Button', identifier: 'sign-in-button', label: 'Sign in', frame: { x: 106, y: 196, width: 66, height: 24 } },
  ]
}
