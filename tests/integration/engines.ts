import type { TestContext } from 'node:test'
import type { OutgoingMessage, Transport } from '../../src/browser/cdp/transport.ts'
import type { LaunchOptions, OwnedBrowser } from '../../src/browser/contract.ts'
import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { isRecord } from '../../src/browser/cdp/message.ts'
import { PipeTransport } from '../../src/browser/cdp/transport.ts'
import { signalGroup } from '../../src/browser/chromium-process.ts'
import { launchFirefox } from '../../src/browser/firefox/launch.ts'
import { FirefoxBrowser } from '../../src/browser/firefox/browser.ts'
import { firefoxRoute } from '../../src/browser/firefox/route.ts'
import { launchBrowser } from '../../src/browser/launch.ts'
import { launchWebKit } from '../../src/browser/webkit/browser.ts'
import { webKitPin } from '../../src/browser/webkit/build.ts'
import { errorCode } from '../../src/shared/error-code.ts'
import { browserPath } from '../support/test-browser.ts'
import { firefoxGate } from './firefox-gate.ts'

// One place that says which web engine an integration test drives, so a suite written against Chromium runs unchanged
// on another engine: a file such as `firefox-basic.test.ts` sets RETEST_TEST_ENGINE and imports the suites, whose
// harness launches, configures and names the browser through `engineUnderTest()`. Assertions never branch on the
// engine; a case whose instrument only exists on one engine's protocol says so through `protocolOnly`.

/** The web engines the integration tests can drive. */
export type EngineName = 'chromium' | 'firefox' | 'webkit'

/**
 * How a test launches an engine's browser: where its log goes, whether it shows, and how its output is redacted when a
 * test asks. The engine knows its executable.
 */
export type EngineLaunch = Pick<LaunchOptions, 'logFile' | 'headless' | 'redact' | 'redactStream'>

/**
 * One engine as the integration tests use it. `launch` starts its browser for a test that drives a driver directly.
 * `target` is a config target on the engine as TypeScript source, with `settings` (source too, such as
 * `baseUrl: 'http://127.0.0.1:4173'`) inside it; `build` picks the second distinct build a test asks for, where the
 * machine has one, and the same build otherwise. `secondBuild` is `distinct` only for an engine whose second target is
 * another build; a test that asks for two builds on any other engine runs one build twice, and must say so.
 * `environment` is what a `retest` process needs to start this engine on this machine, beside its config.
 */
export type TestEngine = {
  readonly name: EngineName
  readonly label: string
  launch(options: EngineLaunch, timeoutMs: number): Promise<OwnedBrowser>
  /**
   * Launches the engine's browser with `gate` between Retest and it, read in the engine's own protocol: the one hook a
   * case that puts a message exactly where a race would needs. An engine without it skips such a case, saying so.
   */
  launchGated?(options: EngineLaunch, timeoutMs: number, gate: InputGate): Promise<OwnedBrowser>
  /** Ends a browser the test launched at once, as a crash would, by what the engine's driver owns of it. */
  crash?(browser: OwnedBrowser): void
  target(settings?: string, build?: 'first' | 'second'): string
  readonly secondBuild?: 'distinct'
  readonly environment: Readonly<Record<string, string>>
}

/** A piece of input as every engine's protocol carries it: a key's down, character and up halves, or inserted text. */
export type GatedInput = 'key down' | 'key char' | 'key up' | 'text'

/**
 * What a case does to the messages between Retest and the browser, in no one protocol's words: hold a piece of input
 * back until a promise settles, and hear the address of each document the page's main frame finishes loading.
 */
export type InputGate = {
  /** A promise to hold the input back for, or undefined to let it go at once. */
  hold?: (input: GatedInput) => Promise<void> | undefined
  loaded?: (url: string) => void
}

const defaultFirefox = '/Applications/Firefox.app/Contents/MacOS/firefox'

const defaultSecondChromium = join(
  homedir(),
  'Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
)

const chromium: TestEngine = {
  name: 'chromium',
  label: 'Chrome',
  launch: (options, timeoutMs) => launchBrowser({ ...options, executablePath: browserPath() }, timeoutMs),
  launchGated: (options, timeoutMs, gate) => launchBrowser({ ...options, executablePath: browserPath() }, timeoutMs, (pipe) => chromiumGate(new PipeTransport(pipe), gate)),
  crash: (browser) => {
    signalGroup(browser.pid, 'SIGKILL')
  },
  target: (settings, build) => {
    if (build !== 'second') return `chrome({ ${settings ?? ''} })`
    const second = process.env['RETEST_TEST_SECOND_BROWSER'] || defaultSecondChromium
    if (!existsSync(second)) throw new Error(`No second browser to test with: set RETEST_TEST_SECOND_BROWSER, or unpack Chrome for Testing at ${defaultSecondChromium}`)
    return `chromium({ executablePath: ${JSON.stringify(second)}, ${settings ?? ''} })`
  },
  secondBuild: 'distinct',
  environment: {},
}

const firefox: TestEngine = {
  name: 'firefox',
  label: 'Firefox',
  launch: (options, timeoutMs) => launchFirefox({ ...options, executablePath: firefoxPath(), route: testFirefoxRoute() }, timeoutMs),
  launchGated: (options, timeoutMs, gate) => launchFirefox({ ...options, executablePath: firefoxPath(), route: testFirefoxRoute() }, timeoutMs, firefoxGate(gate)),
  crash: (browser) => {
    if (!(browser instanceof FirefoxBrowser)) throw new Error('The Firefox crash gate needs the Firefox browser this test launched')
    browser.crash()
  },
  // The machine has one Firefox, so a test that asks for a second build gets the same one.
  target: (settings) => `{ browser: 'firefox', executablePath: ${JSON.stringify(firefoxPath())}, ${settings ?? ''} }`,
  get environment() {
    return { RETEST_FIREFOX_ROUTE: testFirefoxRoute() }
  },
}

const webkit: TestEngine = {
  name: 'webkit',
  label: 'WebKit',
  launch: (options, timeoutMs) => launchWebKit(webKitOptions(options), timeoutMs),
  launchGated: (options, timeoutMs, gate) => launchWebKit(webKitOptions(options), timeoutMs, (pipe) => webKitGate(new PipeTransport(pipe), gate)),
  // The browser's main process leads a process group of its own, which this test launched; its helpers end with it.
  crash: (browser) => {
    process.kill(-browser.pid, 'SIGKILL')
  },
  // The machine has one WebKit build, so a test that asks for a second gets the same one.
  target: (settings) => `{ browser: 'webkit', executablePath: ${JSON.stringify(webKitPath())}, ${settings ?? ''} }`,
  environment: {},
}

// An engine whose driver a lane has not wired in yet has no entry; asking for it fails by name.
const engines: Readonly<Partial<Record<EngineName, TestEngine>>> = { chromium, firefox, webkit }

/**
 * The engine the integration tests drive: RETEST_TEST_ENGINE, or Chromium when it is unset.
 *
 * @example engineUnderTest().name // 'chromium'
 */
export function engineUnderTest(): TestEngine {
  const named = process.env['RETEST_TEST_ENGINE'] ?? 'chromium'
  const found = Object.entries(engines).find(([name]) => name === named)?.[1]
  if (found === undefined) throw new Error(`RETEST_TEST_ENGINE names ${JSON.stringify(named)}, and the integration tests have no such engine: ${Object.keys(engines).join(', ')}.`)
  return found
}

/**
 * Whether a case can run on the engine under test: true when it can, and otherwise false after marking the test
 * skipped with `reason`, for a case whose instrument only exists on `engine`'s protocol, such as a transport that
 * holds a DevTools message back. The caller returns at once on false. Never used to excuse a difference in behaviour.
 *
 * @example if (!protocolOnly(t, 'chromium', 'the gate holds DevTools messages')) return
 */
export function protocolOnly(t: { skip(message?: string): void }, engine: EngineName, reason: string): boolean {
  const current = engineUnderTest().name
  if (current === engine) return true
  t.skip(`${reason}, which ${current} does not speak`)
  return false
}

/**
 * Launches a headless browser of the engine under test with its transport behind `gate`, closed after the test with its
 * process group checked. An engine with no gate marks the test skipped with `reason` and gives undefined; the caller
 * returns at once on that.
 *
 * @example const browser = await launchWithGate(t, { hold: (input) => (input === 'key up' ? new Promise(() => {}) : undefined) }, 'the gate holds a key up back')
 */
export async function launchWithGate(t: TestContext, gate: InputGate, reason: string): Promise<OwnedBrowser | undefined> {
  const engine = engineUnderTest()
  if (engine.launchGated === undefined) {
    t.skip(`${reason}, and the ${engine.label} entry of engines.ts supplies no gate`)
    return undefined
  }
  const folder = await mkdtemp(join(tmpdir(), 'retest-browser-test-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const browser = await engine.launchGated({ logFile: join(folder, 'browser.log'), headless: true }, 30_000, gate)
  t.diagnostic(`browser ${browser.product} ${browser.version}, pid and process group ${browser.pid}`)
  t.after(async () => {
    await browser.close(5000)
    assert.equal(signalGroup(browser.pid, 0), false, `process group ${browser.pid} should be gone`)
  })
  return browser
}

/**
 * Ends the browser of the engine under test at once, as a crash would; an engine whose entry cannot fails by name.
 *
 * @example crashBrowser(browser)
 */
export function crashBrowser(browser: OwnedBrowser): void {
  const engine = engineUnderTest()
  if (engine.crash === undefined) throw new Error(`The ${engine.label} entry of engines.ts cannot end its browser as a crash would.`)
  engine.crash(browser)
}

// Chrome's protocol: key events and text insertion are commands of their own, and the main frame's documents are told
// by `Page.frameNavigated` and its `load` lifecycle event.
function chromiumGate(inner: Transport, gate: InputGate): Transport {
  const frames = new Map<string, string>()
  return gatedTransport(inner, {
    inputOf: (message) => {
      const params = isRecord(message['params']) ? message['params'] : {}
      if (message['method'] === 'Input.insertText') return 'text'
      if (message['method'] !== 'Input.dispatchKeyEvent') return undefined
      return params['type'] === 'keyUp' ? 'key up' : params['type'] === 'char' ? 'key char' : 'key down'
    },
    heard: (message) => {
      const params = isRecord(message['params']) ? message['params'] : {}
      const frame = isRecord(params['frame']) ? params['frame'] : undefined
      if (message['method'] === 'Page.frameNavigated' && frame !== undefined && frame['parentId'] === undefined && typeof frame['id'] === 'string' && typeof frame['url'] === 'string') frames.set(frame['id'], frame['url'])
      const loaded = message['method'] === 'Page.lifecycleEvent' && params['name'] === 'load' && typeof params['frameId'] === 'string' ? frames.get(params['frameId']) : undefined
      if (loaded !== undefined) gate.loaded?.(loaded)
    },
    hold: gate.hold,
  })
}

// WebKit's protocol: a key event goes to the page proxy, text goes to the page target wrapped in
// `Target.sendMessageToTarget`, and the target's events come back wrapped in `Target.dispatchMessageFromTarget`.
function webKitGate(inner: Transport, gate: InputGate): Transport {
  const frames = new Map<string, string>()
  const unwrapped = (message: Record<string, unknown>, method: string): Record<string, unknown> | undefined => {
    const params = isRecord(message['params']) ? message['params'] : {}
    if (message['method'] !== method || typeof params['message'] !== 'string') return undefined
    const inner: unknown = JSON.parse(params['message'])
    return isRecord(inner) ? inner : undefined
  }
  return gatedTransport(inner, {
    inputOf: (message) => {
      const params = isRecord(message['params']) ? message['params'] : {}
      if (message['method'] === 'Input.dispatchKeyEvent') return params['type'] === 'keyUp' ? 'key up' : 'key down'
      return unwrapped(message, 'Target.sendMessageToTarget')?.['method'] === 'Page.insertText' ? 'text' : undefined
    },
    heard: (message) => {
      const event = unwrapped(message, 'Target.dispatchMessageFromTarget')
      const params = event !== undefined && isRecord(event['params']) ? event['params'] : {}
      const frame = isRecord(params['frame']) ? params['frame'] : undefined
      if (event?.['method'] === 'Page.frameNavigated' && frame !== undefined && frame['parentId'] === undefined && typeof frame['id'] === 'string' && typeof frame['url'] === 'string') frames.set(frame['id'], frame['url'])
      const loaded = event?.['method'] === 'Page.loadEventFired' && typeof params['frameId'] === 'string' ? frames.get(params['frameId']) : undefined
      if (loaded !== undefined) gate.loaded?.(loaded)
    },
    hold: gate.hold,
  })
}

type GateReading = {
  inputOf: (message: Record<string, unknown>) => GatedInput | undefined
  heard: (message: Record<string, unknown>) => void
  hold: InputGate['hold']
}

function gatedTransport(inner: Transport, reading: GateReading): Transport {
  return {
    listen(handlers) {
      inner.listen({
        ...handlers,
        message(text) {
          const message: unknown = JSON.parse(text)
          if (isRecord(message)) reading.heard(message)
          handlers.message(text)
        },
      })
    },
    send(text) {
      const message: unknown = JSON.parse(text)
      const input = isRecord(message) ? reading.inputOf(message) : undefined
      const held = input === undefined ? undefined : reading.hold?.(input)
      if (held === undefined) return inner.send(text)
      return heldMessage(held, () => inner.send(text))
    },
    close: () => inner.close(),
  }
}

// A message that goes out once the hold ends, unless it was withdrawn by then.
function heldMessage(held: Promise<void>, send: () => OutgoingMessage): OutgoingMessage {
  let sent: OutgoingMessage | undefined
  let withdrawn = false
  void held.then(() => {
    if (!withdrawn) sent = send()
  })
  return {
    get written() {
      return sent?.written ?? false
    },
    withdraw() {
      withdrawn = true
      sent?.withdraw()
    },
  }
}

// The WebKit build's launch options from a test's, the build from RETEST_TEST_WEBKIT or the cache.
function webKitOptions(options: EngineLaunch) {
  const redact = options.redact === undefined ? {} : { redact: options.redact }
  const stream = options.redactStream === undefined ? {} : { redactStream: options.redactStream }
  return { buildPath: webKitPath(), buildSource: 'RETEST_TEST_WEBKIT', logFile: options.logFile, headless: options.headless, ...redact, ...stream }
}

/**
 * The Firefox the tests drive: RETEST_TEST_FIREFOX, or Firefox where macOS installs it.
 *
 * @example firefoxPath() // '/Applications/Firefox.app/Contents/MacOS/firefox'
 */
export function firefoxPath(): string {
  const configured = process.env['RETEST_TEST_FIREFOX']
  if (configured) return configured
  if (existsSync(defaultFirefox)) return defaultFirefox
  throw new Error(`No Firefox to test with: set RETEST_TEST_FIREFOX, or install Firefox at ${defaultFirefox}`)
}

/**
 * How the tests start Firefox. RETEST_FIREFOX_ROUTE when it is set. Otherwise the product's default, spawn, unless
 * this process may not read Firefox's data folder on macOS: a host app without that grant never gets a spawned Firefox
 * to start (the Phase 1 record shows why), so the tests take the Launch Services route there and say so.
 *
 * @example testFirefoxRoute() // 'spawn'
 */
export function testFirefoxRoute(): 'spawn' | 'launch-services' {
  const configured = firefoxRoute(process.env)
  if (!configured.ok) throw new Error(configured.message)
  if (process.env['RETEST_FIREFOX_ROUTE'] !== undefined && process.env['RETEST_FIREFOX_ROUTE'] !== '') return configured.route
  return firefoxDataReadable() ? 'spawn' : 'launch-services'
}

/**
 * The WebKit build the tests drive: RETEST_TEST_WEBKIT, or the pinned build where Playwright's installer unpacks it on
 * macOS. Without one the tests fail rather than skip.
 *
 * @example webKitPath() // '/Users/me/Library/Caches/ms-playwright/webkit-2359'
 */
export function webKitPath(): string {
  const configured = process.env['RETEST_TEST_WEBKIT']
  if (configured) return configured
  const cached = join(homedir(), 'Library', 'Caches', 'ms-playwright', `webkit-${webKitPin.revision}`)
  if (existsSync(cached)) return cached
  throw new Error(`No WebKit build to test with: set RETEST_TEST_WEBKIT, or unpack Playwright's WebKit build ${webKitPin.revision} at ${cached}`)
}

function firefoxDataReadable(): boolean {
  if (process.platform !== 'darwin') return true
  try {
    readdirSync(join(homedir(), 'Library', 'Application Support', 'Firefox'))
    return true
  } catch (error) {
    return errorCode(error) !== 'EPERM'
  }
}
