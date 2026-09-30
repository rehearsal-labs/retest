import type { TestContext } from 'node:test'
import type { OutgoingMessage, Transport } from '../../src/browser/cdp/transport.ts'
import type { NewPageOptions, OwnedBrowser, OwnedPage } from '../../src/browser/contract.ts'
import type { AriaRole } from '../../src/protocol/aria-role.ts'
import type { CommandResult, Observation } from '../../src/protocol/commands.ts'
import type { Failure } from '../../src/protocol/failures.ts'
import type { LocatorRecipe } from '../../src/protocol/locator.ts'
import type { TaskApp, TaskAppOptions } from '../../fixtures/task-app/server.ts'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { startTaskApp } from '../../fixtures/task-app/server.ts'
import { isRecord } from '../../src/browser/cdp/message.ts'
import { PipeTransport } from '../../src/browser/cdp/transport.ts'
import { signalGroup } from '../../src/browser/chromium-process.ts'
import { launchBrowser } from '../../src/browser/launch.ts'
import { describeLocator } from '../../src/protocol/locator.ts'

const DEFAULT_BROWSER = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

/** The budgets these tests give opening a page and closing the browser. */
export const setupMs = 10_000
export const closeMs = 5000

export function browserPath(): string {
  const configured = process.env['RETEST_TEST_BROWSER']
  if (configured) return configured
  if (existsSync(DEFAULT_BROWSER)) return DEFAULT_BROWSER
  throw new Error(`No browser to test with: set RETEST_TEST_BROWSER, or install Google Chrome at ${DEFAULT_BROWSER}`)
}

/** A folder for one test's files, removed after it. */
export async function scratchFolder(t: TestContext): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'retest-browser-test-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  return folder
}

/** Launches a headless browser that is closed, and its process group checked, after the test. */
export function launch(t: TestContext): Promise<OwnedBrowser> {
  return launchThrough(t, (pipe) => new PipeTransport(pipe))
}

/**
 * What a test may do to the messages between Retest and the browser: hold a command back, and watch everything
 * the browser sends. It lets a test put a message exactly where a race would.
 */
export type Gate = {
  /** A promise to hold the command back for, by method and parameters, or undefined to let it go at once. */
  hold?: (method: string, params: unknown) => Promise<void> | undefined
  /** Sees every message from the browser before Retest does. */
  watch?: (message: Record<string, unknown>) => void
}

/** Launches a headless browser whose messages pass through `gate`, closed and checked after the test. */
export function launchGated(t: TestContext, gate: Gate): Promise<OwnedBrowser> {
  return launchThrough(t, (pipe) => gatedTransport(new PipeTransport(pipe), gate))
}

async function launchThrough(t: TestContext, transport: Parameters<typeof launchBrowser>[2]): Promise<OwnedBrowser> {
  const folder = await scratchFolder(t)
  const browser = await launchBrowser({ executablePath: browserPath(), logFile: join(folder, 'browser.log'), headless: true }, undefined, transport)
  t.diagnostic(`browser ${browser.product} ${browser.version}, pid and process group ${browser.pid}`)
  t.after(async () => {
    await browser.close(closeMs)
    assert.equal(groupExists(browser.pid), false, `process group ${browser.pid} should be gone`)
  })
  return browser
}

function gatedTransport(inner: Transport, gate: Gate): Transport {
  return {
    listen(handlers) {
      inner.listen({
        ...handlers,
        message(text) {
          const message: unknown = JSON.parse(text)
          if (!isRecord(message)) return handlers.message(text)
          gate.watch?.(message)
          handlers.message(text)
        },
      })
    },
    send(text) {
      const message: unknown = JSON.parse(text)
      const method = isRecord(message) ? message['method'] : undefined
      const held = typeof method === 'string' && isRecord(message) ? gate.hold?.(method, message['params']) : undefined
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

/** One browser for every test in a file, as a run has, closed and checked after the last test. */
export function sharedBrowser(): () => OwnedBrowser {
  let browser: OwnedBrowser | undefined
  let folder: string | undefined
  before(async () => {
    folder = await mkdtemp(join(tmpdir(), 'retest-browser-test-'))
    browser = await launchBrowser({ executablePath: browserPath(), logFile: join(folder, 'browser.log'), headless: true })
  })
  after(async () => {
    if (browser !== undefined) {
      await browser.close(closeMs)
      assert.equal(groupExists(browser.pid), false, `process group ${browser.pid} should be gone`)
    }
    if (folder !== undefined) await rm(folder, { recursive: true, force: true })
  })
  return () => {
    assert.ok(browser !== undefined, 'the shared browser did not launch')
    return browser
  }
}

export async function openPage(t: TestContext, browser: OwnedBrowser, baseUrl?: string, options: Omit<NewPageOptions, 'baseUrl'> = {}): Promise<OwnedPage> {
  const page = await browser.newPage(baseUrl === undefined ? options : { ...options, baseUrl }, setupMs)
  t.after(() => page.dispose(2000))
  return page
}

export async function openApp(t: TestContext, options?: TaskAppOptions): Promise<TaskApp> {
  const app = await startTaskApp(options)
  t.after(() => app.close())
  return app
}

export type Pages = { url: string; posts(path: string): number }

/** `hold` gives a promise each page request waits for before it is answered, as a slow or silent server would. */
export type ServeOptions = { hold?: () => Promise<void> }

/** Serves fixed HTML at each path, counts POST requests by path, and never finishes a response to `/hang`. */
export async function servePages(t: TestContext, pages: Record<string, string>, options: ServeOptions = {}): Promise<Pages> {
  const posts = new Map<string, number>()
  const server = createServer(async (request, response) => {
    const path = request.url ?? '/'
    if (request.method === 'POST') {
      posts.set(path, (posts.get(path) ?? 0) + 1)
      response.end()
      return
    }
    await options.hold?.()
    if (path === '/hang') {
      response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
      return
    }
    const html = pages[path]
    response.writeHead(html === undefined ? 404 : 200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    response.end(html ?? 'Not found')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  return { url: `http://127.0.0.1:${address.port}`, posts: (path) => posts.get(path) ?? 0 }
}

/** A locator, or the test id of one, which is how most of these tests name elements. */
export type Target = string | LocatorRecipe

export function byTestId(value: string): LocatorRecipe {
  return { by: 'testId', value }
}

export function byRole(role: AriaRole, name?: string, exact?: boolean): LocatorRecipe {
  return { by: 'role', role, ...(name === undefined ? {} : { name }), ...(exact === undefined ? {} : { exact }) }
}

export function byLabel(text: string, exact?: boolean): LocatorRecipe {
  return { by: 'label', text, ...(exact === undefined ? {} : { exact }) }
}

export function byText(text: string, exact?: boolean): LocatorRecipe {
  return { by: 'text', text, ...(exact === undefined ? {} : { exact }) }
}

function locatorOf(target: Target): LocatorRecipe {
  return typeof target === 'string' ? byTestId(target) : target
}

export function goto(page: OwnedPage, url: string, timeoutMs = 5000): Promise<CommandResult> {
  return page.execute({ kind: 'goto', url }, timeoutMs)
}

export function click(page: OwnedPage, target: Target, timeoutMs = 2000): Promise<CommandResult> {
  return page.execute({ kind: 'click', locator: locatorOf(target) }, timeoutMs)
}

export function tap(page: OwnedPage, target: Target, timeoutMs = 2000): Promise<CommandResult> {
  return page.execute({ kind: 'tap', locator: locatorOf(target) }, timeoutMs)
}

export function fill(page: OwnedPage, target: Target, value: string, timeoutMs = 2000): Promise<CommandResult> {
  return page.execute({ kind: 'fill', locator: locatorOf(target), value }, timeoutMs)
}

/** Presses a key on the element `target` names, or, with none, on the page's keyboard. */
export function press(page: OwnedPage, target: Target | undefined, key: string, timeoutMs = 2000): Promise<CommandResult> {
  const locator = target === undefined ? {} : { locator: locatorOf(target) }
  return page.execute({ kind: 'press', ...locator, key }, timeoutMs)
}

export async function observe(page: OwnedPage, target: Target): Promise<Observation> {
  const result = await page.execute({ kind: 'observe', locator: locatorOf(target) }, 2000)
  assert.ok(result.ok && result.kind === 'observe', JSON.stringify(result))
  return result.observation
}

/** Looks again, as an assertion would, until the observation satisfies `expected` or the time runs out. */
export async function observeUntil(
  page: OwnedPage,
  target: Target,
  expected: (observation: Observation) => boolean,
  timeoutMs = 5000,
): Promise<Observation> {
  const end = performance.now() + timeoutMs
  for (;;) {
    const observation = await observe(page, target)
    if (expected(observation)) return observation
    if (performance.now() > end) assert.fail(`${describeLocator(locatorOf(target))} still reads ${JSON.stringify(observation)}`)
    await delay(25)
  }
}

export function assertOk(result: CommandResult): void {
  assert.equal(result.ok, true, JSON.stringify(result))
}

export function failureOf(result: CommandResult): Failure {
  assert.ok(!result.ok, `expected a failure, received ${JSON.stringify(result)}`)
  return result.failure
}

export async function timed<T>(work: Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now()
  const value = await work
  return { value, ms: performance.now() - start }
}

/** Reports whether any process of a group this test started is still there, reaped or not. */
export function groupExists(pgid: number): boolean {
  return signalGroup(pgid, 0)
}

/** Waits until the server has counted `count` POST requests to `path`, which the page sends as a signal. */
export async function awaitPosts(site: Pages, path: string, count: number, timeoutMs = 5000): Promise<void> {
  const end = performance.now() + timeoutMs
  while (site.posts(path) < count) {
    if (performance.now() > end) assert.fail(`the page sent ${site.posts(path)} of ${count} POST requests to ${path}`)
    await delay(10)
  }
}

/** Waits for `promise`, failing with `message` if it has not settled within `timeoutMs`. */
export function within<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new assert.AssertionError({ message })), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

export async function waitForGroupEnd(pgid: number, timeoutMs = 5000): Promise<void> {
  const end = performance.now() + timeoutMs
  while (groupExists(pgid)) {
    if (performance.now() > end) assert.fail(`process group ${pgid} still exists after ${timeoutMs} ms`)
    await delay(20)
  }
}

/** The profile folder a running browser was started with, read from its command line. */
export async function profileOf(pid: number): Promise<string> {
  const { stdout } = await promisify(execFile)('ps', ['-ww', '-o', 'command=', '-p', String(pid)])
  const match = /--user-data-dir=(\S+)/.exec(stdout)
  assert.ok(match?.[1] !== undefined, `pid ${pid} has no --user-data-dir`)
  return match[1]
}

/** Lines of `ps` that mention a path, which every browser process carries in its command line. */
export async function processesUsing(path: string): Promise<string[]> {
  const { stdout } = await promisify(execFile)('ps', ['-axww', '-o', 'pid=,pgid=,command='])
  return stdout.split('\n').filter((line) => line.includes(path))
}
